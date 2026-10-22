def add(a, b):
    return a + b

def fact(n):
    if n <= 1:
        return 1
    return n * fact(n - 1)

def greet(name: str) -> str:
    return "Привет, " + name + "!"

print(add(2, 3))
print(fact(10))
print(greet("Мир"))
print("сумма:", add(10, 20), "конец")
